#!/usr/bin/env node
'use strict';
/**
 * forge-contextbudget.cjs — meters the ALWAYS-LOADED instruction surface and guards it against silent
 * growth (2026-08-01). Zero-dependency (fs/path/os only), Windows-safe, ADVISORY-ONLY.
 *
 * WHY THIS EXISTS (measured, not assumed). Every session of every project loads a fixed instruction chain
 * before the owner types anything: the global CLAUDE.md, each `@`-include it pulls in, the ECC common
 * rules, the workspace CLAUDE.md, the project CLAUDE.md, and the name+description of every skill. Measured
 * on 2026-08-01 (`.claude/forge-research/sweep-2/METING-contextbudget-2026-08-01.md`): ~21.830 estimated
 * tokens. Nothing in forge-doctor.cjs counted a single one of them. That matters because the chain only
 * ever GROWS — every new governance rule is added, nothing is ever removed — and the failure mode is
 * SILENT: on 31 July the skill list was truncated by exactly this creep, and the first symptom was 48
 * skills going invisible, not a warning. Without a number, "the context is getting heavier" is a feeling;
 * with one, it is a regression you can point at.
 *
 * THE SKILL SURFACE IS THREE CATALOGS, NOT ONE (widened 2026-08-01, second pass). The first version of this
 * file counted only `<project>/.claude/skills` — 57 skills — and printed that as THE skill catalog. Measured
 * the same day: the session also carries `~/.claude/skills` (109) and `~/.claude/plugins` (112). The meter
 * was covering 57 of 278 skills, 21% of the real surface, and reporting it as complete. A meter that reads
 * too low is worse than no meter, because it converts an unknown into a false reassurance. All three are now
 * measured and reported as SEPARATE posts — never summed into one opaque figure, because they have different
 * owners, different lifecycles, and only one of them is ours to edit. Two of them live outside the project
 * root: they are opened for READING and counted, never written (see THE PROJECT BOUNDARY below).
 *
 * TWO WAYS TO UNDER-REPORT, BOTH MADE LOUD. (1) The walk not going deep enough: the same day, a hand-written
 * count with its recursion capped at 4 found 2 plugin skills instead of 112, silently — the plugin layout is
 * six directories deep. So the walk now records whether it stopped at its cap and raises `depth_capped` as a
 * finding when it did. (2) A source quietly falling off the machine: if the baseline recorded skills for a
 * source and that source now yields zero, `source_vanished` is a finding. An absent-from-the-start source is
 * different — that is an honest zero, and it still gets its own post with a note saying why it is zero.
 *
 * WHAT "COUNTED" MEANS FOR A SKILL, precisely, because two honest people will count differently. This module
 * counts the VALUE text of the frontmatter `name` and `description` — not the `name:`/`description:` keys,
 * not the YAML indentation, not the rest of the block. Measured across the two out-of-project catalogs on
 * 2026-08-01: value-only 26.990 + 26.777 chars · including the key prefixes and indentation 29.171 + 28.813 ·
 * the whole frontmatter block 31.205 + 31.138. A hand count made the same day landed at 27.383 + 28.590, i.e.
 * between the first two — which is the ordinary spread between counting conventions, not a discrepancy to
 * chase. Value-only is the choice here because it is what the model is actually shown per skill; the point of
 * writing the three variants down is that nobody later "corrects" this number to match a different convention
 * and calls the difference a regression.
 *
 * WHAT IT IS NOT. The token figures here are ESTIMATES: characters / `chars_per_token` (default 4), the
 * same rough divisor forge-repomap uses and labels as an estimate there too. No tokenizer runs. Every
 * number is named `approx_*` and every report carries `estimate_note` saying so in plain words. Anyone
 * putting a hard budget on these should first calibrate against a real `/context` reading. Reporting a
 * fake-precise token count would be worse than reporting nothing.
 *
 * THE PROJECT BOUNDARY (this project's CLAUDE.md, "Project isolation"). Most of the chain lives OUTSIDE
 * the project root (`~/.claude/...`). Those files are opened for READING and counted. They are never
 * written, never edited, never "tidied" — every out-of-project post is flagged `in_project: false` +
 * `access: 'read-only'` in the report itself, and a test asserts their bytes and mtimes are untouched
 * after a full measure + baseline write. The ONLY file this module ever writes is its own config, inside
 * the project's own `.claude/config/orchestration/`.
 *
 * MODEL:
 *   measure(root, opts)       -> report (see below) — pure read, writes nothing at all
 *   writeBaseline(root, opts) -> {path, baseline} — records the CURRENT measurement as the new baseline
 *   readConfig(root) / saveConfig(root, cfg) — the config round-trip (thresholds + baseline live there)
 *   estimateTokens(chars, per) -> ceil(chars / per)
 *
 * REPORT: {ok, generated_at, chars_per_token, estimate_note, posts[], skill_sources[], total_chars,
 *          total_approx_tokens, potential_chars, potential_approx_tokens, plugin_enablement, baseline,
 *          thresholds, findings[], notes[], new_posts[], retired_baseline_posts[], max_skill_depth, reason}
 *   posts[]  : {id, kind, label, path|paths, in_project, access, exists, chars, approx_tokens, ...}
 *              a catalog post also carries the loaded/not-loaded split: skills (LOADED), skills_on_disk,
 *              disabled_skills, disabled_chars, disabled_approx_tokens, unattributed_skills,
 *              plugin_attribution[] and disabled_files[]. `chars`/`approx_tokens` are the LOADED set ONLY.
 *   total_*  : LOADED weight. potential_* : present-on-disk-but-off weight — reported beside the total,
 *              never inside it (see PLUGIN ENABLEMENT below).
 *   skill_sources[]: the three catalog posts again, side by side, each with its own count — a convenience
 *              view for callers that want the breakdown; it is a VIEW of posts[], never an extra total.
 *   findings[]: {kind: 'dead_include'|'over_baseline'|'over_baseline_total'|'depth_capped'|'source_vanished',
 *              id, detail} — these set ok=false.
 *   notes[]  : {kind: 'measurement_widened'|'retired_post', id, detail} — INFORMATIONAL, never flip ok. This
 *              is the correction-vs-regression split: when the total rises because the meter started counting
 *              something it had always missed, that is a note explaining the correction, not a false alarm.
 *   ok = no findings. ADVISORY: forge-doctor.cjs surfaces this without ever flipping its hard verdict.
 *
 * CLI:
 *   node forge-contextbudget.cjs [--root DIR] [--json]        # measure and print
 *   node forge-contextbudget.cjs --write-baseline [--root DIR] # deliberately re-baseline
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_REL = path.join('config', 'orchestration', 'FORGE_CONTEXT_BUDGET.json');
const ESTIMATE_NOTE = 'ESTIMATE ONLY: tokens are characters / chars_per_token. No tokenizer ran — these are '
  + 'not exact token counts. Calibrate against a real /context reading before treating any of them as a hard budget.';

/** DEFAULT_THRESHOLDS — a post is only reported when it grows past BOTH a relative and an absolute floor
 *  (whichever is larger), because the measurement is an estimate: a one-line edit moves a number by a
 *  handful of "tokens" that no tokenizer would agree on, and a meter that cries wolf gets ignored, which
 *  would leave the surface unguarded exactly as it was before. Every value here is overridable in the
 *  config file — nothing about the policy is hardcoded, only its starting point. */
const DEFAULT_THRESHOLDS = {
  post_growth_pct: 10,          // a post may drift 10% over its baseline …
  post_growth_min_tokens: 50,   // … but never less than 50 estimated tokens of headroom
  total_growth_pct: 5,          // the whole chain is held tighter than any single post …
  total_growth_min_tokens: 200, // … with a floor that ignores ordinary editing noise
};
const DEFAULT_CHARS_PER_TOKEN = 4;

/** MAX_SKILL_DEPTH — how many directory levels below a catalog root the SKILL.md walk descends. A skill at
 *  `<root>/<name>/SKILL.md` sits at depth 1; the real plugin layout,
 *  `<root>/marketplaces/<marketplace>/plugins/<plugin>/skills/<skill>/SKILL.md`, sits at depth 6.
 *
 *  WHY 8, and why a limit at all — measured on this machine on 2026-08-01:
 *    project `<project>/.claude/skills`  deepest = 2   (49 at depth 1, 8 at depth 2)
 *    global  `~/.claude/skills`          deepest = 2   (74 at depth 1, 35 at depth 2)
 *    plugin  `~/.claude/plugins`         deepest = 6   (2 at depth 3, 38 at depth 5, 72 at depth 6)
 *  8 = the deepest layout that actually exists (6) plus two levels of headroom, which is enough for a
 *  marketplace that inserts one more namespace or version directory without anyone having to touch this file.
 *  It is BOUNDED rather than infinite so a symlink loop or a vendored tree can never turn a read-only meter
 *  into an unbounded filesystem crawl — the walk also refuses to re-enter a directory it has already resolved.
 *
 *  WHY THE LIMIT CANNOT HIDE ANYTHING: hitting it is RECORDED (`depth_capped` on the post) and raised as a
 *  finding, so a too-shallow cap reads as red, never as a smaller number. That is the whole lesson of the
 *  depth-4 count on 2026-08-01, which reported 2 plugin skills instead of 112 and looked perfectly calm doing
 *  it. Overridable per machine via `max_skill_depth` in the config. */
const MAX_SKILL_DEPTH = 8;

/** SKILL_SOURCES — the three catalogs a session actually carries, in report order. Kept as data (not three
 *  copy-pasted blocks) so adding a fourth source is one line and every source automatically gets the same
 *  post, the same depth guard, the same vanished-source check and the same baseline entry. */
const SKILL_SOURCES = [
  { id: 'skill_catalog_project', key: 'projectSkillsDir', label: 'project skill catalog (.claude/skills)' },
  { id: 'skill_catalog_global', key: 'globalSkillsDir', label: 'global skill catalog (~/.claude/skills)' },
  // `enablement_aware` marks the ONE catalog whose files are not all loaded: a plugin can be switched off, and
  // its skills then sit on disk costing nothing. The project and global catalogs have no such switch, so the
  // flag is data here rather than an `if (id === …)` buried in the measuring code.
  { id: 'skill_catalog_plugins', key: 'pluginSkillsDir', label: 'plugin skill catalog (~/.claude/plugins)', enablement_aware: true },
];

/** ECC_RULES_REL / the default chain locations. These are DEFAULTS, not assertions about the machine: any
 *  of them can be overridden through the config's `paths` block or opts.paths (which is how the tests point
 *  the meter at a synthetic home instead of the owner's real one). */
function defaultPaths() {
  const home = os.homedir();
  return {
    globalClaudeMd: path.join(home, '.claude', 'CLAUDE.md'),
    workspaceClaudeMd: path.join(home, 'CLAUDE.md'),
    eccRulesDir: path.join(home, '.claude', 'rules', 'ecc', 'common'),
    globalSkillsDir: path.join(home, '.claude', 'skills'),
    pluginSkillsDir: path.join(home, '.claude', 'plugins'),
    // the two sources that decide which of the plugin skills on disk are actually LOADED (see PLUGIN
    // ENABLEMENT in the header). Overridable like every other path so tests point at a synthetic home.
    settingsJson: path.join(home, '.claude', 'settings.json'),
    installedPluginsJson: path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
  };
}

// ============================ PLUGIN ENABLEMENT (2026-08-01) =================================================
/** A SKILL.md ON DISK IS NOT THE SAME AS A SKILL IN THE CONTEXT, and until today this meter treated them as
 *  identical. Measured on the owner's machine on 2026-08-01: `~/.claude/settings.json` enables 4 of 15 plugins;
 *  17 SKILL.md sit under a directory literally named `plugin.disabled`; two whole plugin copies are superseded
 *  versions of a plugin whose installed path points elsewhere. Of the 112 plugin SKILL.md found, 34 belong to a
 *  plugin that is actually switched on — 1.705 estimated tokens, not 6.695. The meter was reporting the other
 *  4.990 as loaded weight, and a budget meter that reads 17% high is the mirror image of the 21%-coverage bug
 *  documented above: both replace an unknown with a confident wrong number.
 *
 *  BOTH FIGURES ARE KEPT, because both are real and they answer different questions. What is LOADED is what
 *  costs context on every request. What is ON DISK BUT OFF is POTENTIAL weight — the cost of switching those
 *  plugins on — and that is worth knowing before someone enables five of them. The one thing that must never
 *  happen is the second number being counted as the first, so `chars`/`approx_tokens`/the report total carry
 *  ONLY the loaded set, and the off set travels beside them as `disabled_*` / `potential_*`.
 *
 *  THE DIRECTION OF ERROR IS CHOSEN DELIBERATELY. Where enablement cannot be determined — settings.json absent
 *  or unreadable, a skill that cannot be attributed to any plugin — the skill is counted as LOADED and the
 *  uncertainty is reported (`unattributed_skills`, `plugin_enablement.available:false`). A budget that guesses
 *  low is a false reassurance; a budget that guesses high is merely conservative. The single exception is a
 *  directory named `*.disabled`: that is filesystem truth, not a settings lookup, so it is excluded whether or
 *  not settings.json can be read. */

/** readEnablement(paths) -> {available, reason, enabled_plugins, enabled_count, plugin_count, install_paths,
 *                            enabled_by_name}
 *  Reads BOTH sources: `settings.json`'s `enabledPlugins` map (the on/off switch) and
 *  `plugins/installed_plugins.json` (which physical directory is the INSTALLED copy of each key). The second
 *  matters because a marketplace keeps older versions on disk next to the installed one, and only the
 *  installed one is loaded. An install path that does not exist on disk is dropped here rather than trusted —
 *  the owner's real claude-mem entry points at a directory that is gone while the plugin is very much loaded
 *  from elsewhere, and a stale manifest must not be able to hide a live plugin. */
function readEnablement(P) {
  const settings = readJsonSafe(P.settingsJson);
  const enabled = (settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object') ? settings.enabledPlugins : null;
  const installed = readJsonSafe(P.installedPluginsJson);
  const installPaths = {};
  if (installed && installed.plugins && typeof installed.plugins === 'object') {
    for (const [key, list] of Object.entries(installed.plugins)) {
      const arr = Array.isArray(list) ? list : [list];
      for (const e of arr) {
        if (!e || typeof e.installPath !== 'string') continue;
        let ok = false;
        try { ok = fs.statSync(e.installPath).isDirectory(); } catch { ok = false; }
        if (ok) installPaths[key] = path.resolve(e.installPath);
      }
    }
  }
  if (!enabled) {
    return {
      available: false,
      reason: 'plugin enablement could not be read: no usable `enabledPlugins` map at ' + P.settingsJson
        + ' — every plugin skill is therefore counted as LOADED (over-reporting is the safe direction for a '
        + 'budget), except directories literally named `*.disabled`, which are excluded on filesystem evidence '
        + 'rather than on settings',
      enabled_plugins: {}, enabled_count: 0, plugin_count: 0, install_paths: installPaths, enabled_by_name: {},
    };
  }
  const byName = {};
  let on = 0;
  for (const [key, val] of Object.entries(enabled)) {
    if (val !== true) continue;
    on++;
    const name = key.split('@')[0];
    if (!byName[name]) byName[name] = key;
  }
  return {
    available: true,
    reason: on + ' of ' + Object.keys(enabled).length + ' plugin(s) enabled in ' + P.settingsJson,
    enabled_plugins: enabled, enabled_count: on, plugin_count: Object.keys(enabled).length,
    install_paths: installPaths, enabled_by_name: byName,
  };
}

function isUnder(dir, file) {
  const d = path.resolve(dir) + path.sep;
  const f = path.resolve(file);
  return process.platform === 'win32' ? f.toLowerCase().startsWith(d.toLowerCase()) : f.startsWith(d);
}

/** pluginKeyFromPath(segs, pluginRoot) -> '<plugin>@<marketplace>' | null
 *  The three real layouts on this machine, in the order they are unambiguous:
 *    cache/<marketplace>/<plugin>/<version>/…                      the installed copies
 *    marketplaces/<marketplace>/plugins|external_plugins/<plugin>/… a multi-plugin marketplace checkout
 *    marketplaces/<marketplace>/<dir>/…  with <dir>/.claude-plugin/plugin.json naming the plugin
 *  The third exists because a single-plugin marketplace puts the plugin straight in its root, and the only
 *  trustworthy name for it is the one in its own manifest — guessing from the directory name would have
 *  mis-keyed the owner's claude-mem checkout, whose directory is called `plugin`. */
function pluginKeyFromPath(segs, pluginRoot) {
  if (segs[0] === 'cache' && segs.length >= 4) return segs[2] + '@' + segs[1];
  if (segs[0] === 'marketplaces' && segs.length >= 4 && (segs[2] === 'plugins' || segs[2] === 'external_plugins')) {
    return segs[3] + '@' + segs[1];
  }
  if (segs[0] === 'marketplaces' && segs.length >= 3) {
    const manifest = readJsonSafe(path.join(pluginRoot, segs[0], segs[1], segs[2], '.claude-plugin', 'plugin.json'));
    if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim() + '@' + segs[1];
  }
  return null;
}

/** attributePluginSkill(absPath, pluginRoot, en) -> {plugin_key, enabled, reason}
 *  One SKILL.md -> is it actually loaded. Every branch records WHY, because "34 of 112" is only useful if a
 *  reader can check any single row of it. */
function attributePluginSkill(absPath, pluginRoot, en) {
  const segs = path.relative(pluginRoot, absPath).split(path.sep);
  const disabledDir = segs.find((s) => /\.disabled$/i.test(s));
  if (disabledDir) {
    return { plugin_key: null, enabled: false, reason: 'sits under a directory named `' + disabledDir + '` — disabled on disk, independent of settings' };
  }
  if (!en.available) return { plugin_key: null, enabled: true, reason: 'enablement source unavailable — counted as loaded (never under-report)' };

  let key = null, how = '';
  for (const [k, p] of Object.entries(en.install_paths)) {
    if (isUnder(p, absPath)) { key = k; how = 'under the installed path of ' + k; break; }
  }
  if (!key) { key = pluginKeyFromPath(segs, pluginRoot); if (key) how = 'path/manifest resolves to ' + key; }
  if (!key) {
    return { plugin_key: null, enabled: true, reason: 'could not be attributed to any plugin — counted as loaded (never under-report) and reported as unattributed' };
  }

  // the ONE installed copy wins: another directory claiming the same key is a superseded version left on disk
  const own = en.install_paths[key];
  if (own && !isUnder(own, absPath)) {
    return { plugin_key: key, enabled: false, reason: 'not the installed copy of ' + key + ' (the installed one is ' + own + ') — a stale version left on disk' };
  }
  if (en.enabled_plugins[key] === true) return { plugin_key: key, enabled: true, reason: key + ' is enabled (' + how + ')' };
  if (en.enabled_plugins[key] === false) return { plugin_key: key, enabled: false, reason: key + ' is disabled in enabledPlugins' };

  // the key is not in enabledPlugins at all. Before calling it off, check whether the same PLUGIN is enabled
  // under a different marketplace key — the owner's claude-mem is enabled as `claude-mem@thedotmack` while the
  // copy on disk lives under a `thedotmack-claude-mem` directory, and those skills are demonstrably loaded.
  const name = key.split('@')[0];
  const byName = en.enabled_by_name[name];
  if (byName) {
    const other = en.install_paths[byName];
    if (other && !isUnder(other, absPath)) {
      return { plugin_key: key, enabled: false, reason: 'plugin `' + name + '` is enabled as ' + byName + ', but its installed copy is ' + other + ' — this is a different copy on disk' };
    }
    return { plugin_key: key, enabled: true, reason: 'plugin `' + name + '` is enabled as ' + byName + ' and this is its only copy on disk' };
  }
  return { plugin_key: key, enabled: false, reason: key + ' does not appear in enabledPlugins — never switched on' };
}

function claudeDir(root) { return path.join(root, '.claude'); }
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** estimateTokens — ceil, never floor: a budget meter that rounds DOWN reports less weight than is really
 *  there, which is the one direction a guard must never err in. */
function estimateTokens(chars, perToken) {
  const per = Number.isFinite(perToken) && perToken > 0 ? perToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil((Number.isFinite(chars) ? chars : 0) / per);
}

/** parseIncludes(text) -> ['FRONTEND_WEBSITE_RULES.md', ...] — the `@`-includes a CLAUDE.md pulls in.
 *  Anchored to the START of a line (that is the only position Claude Code treats as an include) so an
 *  ordinary "@mention" mid-sentence, an email address, or an `@` inside prose is never mistaken for one.
 *  Order is preserved and duplicates are collapsed — the same file included twice is loaded once. */
function parseIncludes(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^@([A-Za-z0-9_./-]+\.md)\s*$/.exec(line.trim());
    if (!m) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/** walkSkillCatalog(baseDir, maxDepth) -> {files[], deepest, capped, dirExists}
 *  The one SKILL.md walk this module uses, for every catalog, in or out of the project. It reports THREE
 *  things beyond the file list, and each of them exists because leaving it out is how a walk lies:
 *    deepest — how deep it actually had to go, so a future cap that is too shallow is obvious from the report
 *              alone rather than from someone re-counting by hand;
 *    capped  — whether it refused to descend further, i.e. whether this count may be short;
 *    dirExists — whether the root is even there, which is the difference between "this machine has no plugin
 *              catalog" (an honest zero) and "the catalog is empty" (usually a symptom).
 *  Symlink/cycle guard: every directory is resolved with realpath and visited at most once, so a loop cannot
 *  spin the walk even below the depth cap. Never throws — an unreadable directory is simply not descended. */
function walkSkillCatalog(baseDir, maxDepth) {
  const limit = Number.isFinite(maxDepth) && maxDepth > 0 ? Math.floor(maxDepth) : MAX_SKILL_DEPTH;
  const files = [];
  const seen = new Set();
  let deepest = 0;
  let capped = false;
  let dirExists = false;
  try { dirExists = fs.statSync(baseDir).isDirectory(); } catch { dirExists = false; }
  if (!dirExists) return { files, deepest, capped, dirExists };
  try { seen.add(fs.realpathSync(baseDir)); } catch { seen.add(path.resolve(baseDir)); }
  (function walk(dir, depth) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name === 'SKILL.md' && !e.isDirectory()) { files.push(p); if (depth > deepest) deepest = depth; continue; }
      // isDirectory() is false for a symlinked directory on Windows — stat it rather than trusting the flag
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; } }
      if (!isDir) continue;
      if (depth >= limit) { capped = true; continue; }
      let real; try { real = fs.realpathSync(p); } catch { real = path.resolve(p); }
      if (seen.has(real)) continue;
      seen.add(real);
      walk(p, depth + 1);
    }
  })(baseDir, 0);
  files.sort();
  return { files, deepest, capped, dirExists };
}

/** measureSkillSource — one catalog, one post. Counts ONLY the frontmatter name + description of each skill:
 *  that pair is what the model is shown for every skill whether or not any of them is ever opened, so it is
 *  always-loaded weight, while the body is not. A source with no directory is still a full post (chars 0,
 *  `exists:false`) carrying a `note` that says why it is zero — see the header on honest zeros. */
function measureSkillSource(src, dir, root, perToken, maxDepth, enablement) {
  const walk = walkSkillCatalog(dir, maxDepth);
  // enablement applies to the PLUGIN catalog only — the project and global catalogs are not plugin-managed
  // and have no on/off switch to consult. They keep the plain shape (all found skills are loaded skills).
  const en = (src.enablement_aware && enablement) ? enablement : null;
  const files = [], disabledFiles = [];
  const attribution = new Map();
  let withoutFrontmatter = 0, unattributed = 0;
  for (const abs of walk.files) {
    const text = readFileSafe(abs);
    if (text === null) continue;
    const skill = path.relative(dir, path.dirname(abs)).split(path.sep).join('/') || '.';
    const name = frontmatterField(text, 'name') || '';
    const desc = frontmatterField(text, 'description') || '';
    // a SKILL.md with no name AND no description declares nothing, so it adds nothing to the always-loaded
    // surface — six such files sit in ~/.claude/plugins, prose guides that merely share the filename. They
    // are still COUNTED as found (dropping them would make the walk's number disagree with `find`) but the
    // post says how many they are, so "112 skills" is never read as "112 skills' worth of loaded text".
    if (!name && !desc) withoutFrontmatter++;
    const entry = { skill, chars: name.length + desc.length, name_chars: name.length, description_chars: desc.length };
    if (!en) { files.push(entry); continue; }
    const a = attributePluginSkill(abs, dir, en);
    entry.plugin_key = a.plugin_key;
    entry.reason = a.reason;
    if (a.plugin_key === null && a.enabled) unattributed++;
    const k = a.plugin_key || '(unattributed)';
    if (!attribution.has(k)) attribution.set(k, { plugin_key: a.plugin_key, enabled: a.enabled, reason: a.reason, skills: 0, chars: 0 });
    const row = attribution.get(k);
    row.skills++; row.chars += entry.chars;
    (a.enabled ? files : disabledFiles).push(entry);
  }
  const bySize = (a, b) => b.chars - a.chars || (a.skill < b.skill ? -1 : 1);
  files.sort(bySize); disabledFiles.sort(bySize);
  const chars = files.reduce((n, s) => n + s.chars, 0);
  const disabledChars = disabledFiles.reduce((n, s) => n + s.chars, 0);
  const onDisk = files.length + disabledFiles.length;
  const inProject = isInside(root, dir);
  let note;
  if (!walk.dirExists) {
    note = 'no such directory on this machine (' + dir + ') — an honest zero: this source contributes 0 skills here, '
      + 'and is reported rather than omitted so a missing source can never read as a smaller surface';
  } else if (onDisk === 0) {
    note = 'the directory exists but holds no SKILL.md within ' + (maxDepth || MAX_SKILL_DEPTH) + ' level(s)';
  } else {
    note = onDisk + ' skill(s) on disk, deepest found ' + walk.deepest + ' level(s) down of a maximum of ' + (maxDepth || MAX_SKILL_DEPTH)
      + (withoutFrontmatter ? '; ' + withoutFrontmatter + ' of them declare no frontmatter name/description and so add 0 to the loaded surface' : '');
    if (en) {
      note += '; ' + files.length + ' belong to an ENABLED plugin and are counted as loaded, ' + disabledFiles.length
        + ' are present but NOT loaded (' + estimateTokens(disabledChars, perToken) + ' est. tokens of potential weight, '
        + 'reported separately and never added to the total)';
      if (!en.available) note += '. NOTE: ' + en.reason;
      if (unattributed) {
        note += '; ' + unattributed + ' skill(s) are UNATTRIBUTED (no plugin could be resolved for them) and are '
          + 'counted as LOADED rather than dropped — a budget may over-report, never under-report';
      }
    }
  }
  return {
    id: src.id, kind: 'catalog',
    label: src.label + ' — name+description of ' + files.length + ' loaded skill(s)'
      + (en && disabledFiles.length ? ' (+' + disabledFiles.length + ' present but not loaded)' : ''),
    path: dir,
    in_project: inProject,
    // the SAME two access strings measurePath() uses — one vocabulary for the whole report, so a caller can
    // filter on `access === 'read-only'` without knowing which kind of post it is looking at
    access: inProject ? 'read-write (this project)' : 'read-only',
    exists: walk.dirExists,
    // chars/approx_tokens are the LOADED set only — this is what makes the report total honest
    chars, approx_tokens: estimateTokens(chars, perToken),
    skills: files.length,
    // …and the not-loaded set travels beside it, never inside it
    skills_on_disk: onDisk,
    disabled_skills: disabledFiles.length,
    disabled_chars: disabledChars,
    disabled_approx_tokens: estimateTokens(disabledChars, perToken),
    unattributed_skills: unattributed,
    enablement_aware: !!en,
    plugin_attribution: Array.from(attribution.values()).sort((a, b) => b.chars - a.chars),
    without_frontmatter: withoutFrontmatter,
    deepest_depth: walk.deepest,
    max_depth: maxDepth || MAX_SKILL_DEPTH,
    depth_capped: walk.capped,
    note,
    files,
    disabled_files: disabledFiles,
  };
}

/** frontmatterField — the one field this module needs (name / description) out of the leading `---` block.
 *  Never throws; returns null when there is no frontmatter or no such key.
 *
 *  IT MUST HANDLE MULTI-LINE VALUES, and the reason is measured. The first version read only `key: value` on
 *  one line, which is the shape every SKILL.md in THIS project happens to use. Eight skills in
 *  `~/.claude/skills` and `~/.claude/plugins` use a YAML block scalar instead:
 *      description: |
 *        SPARC (Specification, Pseudocode, …) comprehensive development methodology …
 *  Against those, a first-line-only parser returns the literal string "|" — one character where the real
 *  description is over a hundred — and the catalog total comes out too low with nothing to show it. That is
 *  the same class of silent under-report as a too-shallow directory walk, and it is not acceptable in a meter
 *  whose entire job is to be the number people trust.
 *
 *  Handled: `key: value` · `key: |`/`|-`/`|+`/`>`/`>-`/`>+` block scalars · `key:` followed by an indented
 *  block · a plain scalar folded across indented continuation lines. The value ends at the first line that is
 *  neither blank nor indented — i.e. the next key — so a following field is never swallowed into this one.
 *  Continuation lines are dedented and joined with newlines: for a CHARACTER COUNT the fold style is
 *  irrelevant (literal joins with "\n", folded with " " — one character either way). */
function frontmatterField(text, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const head = new RegExp('^' + key + ':[ \\t]*(.*)$');
  let i = 0;
  for (; i < lines.length; i++) if (head.test(lines[i])) break;
  if (i >= lines.length) return null;
  let first = head.exec(lines[i])[1].trim();
  const isBlock = /^[|>][+-]?\d*$/.test(first);
  if (isBlock) first = '';
  const rest = [];
  for (let j = i + 1; j < lines.length; j++) {
    const ln = lines[j];
    if (/^[ \t]/.test(ln)) { rest.push(ln.replace(/^[ \t]+/, '')); continue; }
    if (ln.trim() === '') { if (isBlock) { rest.push(''); continue; } break; } // a blank line ends a plain scalar
    break; // the next key
  }
  while (rest.length && rest[rest.length - 1] === '') rest.pop();
  const value = [first].concat(rest).filter((s, idx) => idx === 0 ? s !== '' : true).join('\n');
  return value.trim().replace(/^["']|["']$/g, '');
}

/** measurePath — one file post. A missing file is `exists:false, chars:0`, NEVER an omitted post: a post
 *  that silently vanishes from the report would read as "this got cheaper" when it actually got broken. */
function measurePath(id, kind, label, filePath, root, perToken) {
  const text = readFileSafe(filePath);
  const chars = text === null ? 0 : text.length;
  const inProject = isInside(root, filePath);
  return {
    id, kind, label, path: filePath,
    in_project: inProject,
    access: inProject ? 'read-write (this project)' : 'read-only',
    exists: text !== null,
    chars,
    approx_tokens: estimateTokens(chars, perToken),
  };
}
/** isInside — path containment, case-insensitively on Windows. Used only to LABEL a post; nothing in this
 *  module writes to any measured path either way. */
function isInside(root, p) {
  const r = path.resolve(root) + path.sep;
  const q = path.resolve(p);
  return process.platform === 'win32'
    ? q.toLowerCase().startsWith(r.toLowerCase())
    : q.startsWith(r);
}

/** readConfig(root) — the config, with every missing piece defaulted. A missing/corrupt file is NOT an
 *  error: the meter still measures, it simply has no baseline to compare against and says so. */
function readConfig(root) {
  const raw = readJsonSafe(path.join(claudeDir(root), CONFIG_REL)) || {};
  return {
    chars_per_token: Number.isFinite(raw.chars_per_token) && raw.chars_per_token > 0 ? raw.chars_per_token : DEFAULT_CHARS_PER_TOKEN,
    max_skill_depth: Number.isFinite(raw.max_skill_depth) && raw.max_skill_depth > 0 ? Math.floor(raw.max_skill_depth) : MAX_SKILL_DEPTH,
    thresholds: Object.assign({}, DEFAULT_THRESHOLDS, (raw.thresholds && typeof raw.thresholds === 'object') ? raw.thresholds : {}),
    paths: (raw.paths && typeof raw.paths === 'object') ? raw.paths : {},
    baseline: (raw.baseline && typeof raw.baseline === 'object' && raw.baseline.posts && typeof raw.baseline.posts === 'object') ? raw.baseline : null,
    _doc: raw._doc,
  };
}
/** saveConfig(root, cfg) — writes the config, and ONLY the config. This is the single write path in this
 *  file and its destination is always inside the project's own .claude/. */
function saveConfig(root, cfg) {
  const p = path.join(claudeDir(root), CONFIG_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = Object.assign({
    _doc: 'Always-loaded context-surface budget. Written by forge-bin/forge-contextbudget.cjs; read by '
      + 'forge-doctor.cjs as an ADVISORY check. Token figures are ESTIMATES (characters / chars_per_token) — '
      + 'no tokenizer runs. `baseline` is a deliberate snapshot: re-record it with '
      + '`node .claude/forge-bin/forge-contextbudget.cjs --write-baseline` when the growth is intended, '
      + 'so accepting growth is always an explicit act. The skill surface is measured across THREE separate '
      + 'sources (project .claude/skills, ~/.claude/skills, ~/.claude/plugins), reported as separate posts and '
      + 'never summed into one figure; `max_skill_depth` bounds the SKILL.md walk (default 8; the deepest real '
      + 'layout is 6) and a walk that hits it is reported as a `depth_capped` finding rather than a quietly '
      + 'smaller number. Files outside the project root are READ and counted only; this tool never writes them.',
  }, cfg);
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8');
  return p;
}

/** resolvePaths — opts.paths beats config `paths` beats the machine defaults. `projectSkillsDir` is the one
 *  location derived from the root rather than the home directory, and it is still overridable so a test can
 *  point it somewhere synthetic without special-casing it. */
function resolvePaths(cfg, opts, root) {
  const d = defaultPaths();
  d.projectSkillsDir = path.join(claudeDir(root), 'skills');
  const fromCfg = cfg.paths || {};
  const fromOpts = (opts && opts.paths) || {};
  const pick = (k) => fromOpts[k] || fromCfg[k] || d[k];
  return {
    globalClaudeMd: pick('globalClaudeMd'),
    workspaceClaudeMd: pick('workspaceClaudeMd'),
    eccRulesDir: pick('eccRulesDir'),
    projectSkillsDir: pick('projectSkillsDir'),
    globalSkillsDir: pick('globalSkillsDir'),
    pluginSkillsDir: pick('pluginSkillsDir'),
    settingsJson: pick('settingsJson'),
    installedPluginsJson: pick('installedPluginsJson'),
  };
}

/** measure(root, opts) -> report. PURE READ: opens files, writes nothing (see the file header on the
 *  project boundary). Never throws — an unreadable file becomes an honest `exists:false` post. */
function measure(root, opts) {
  opts = opts || {};
  root = path.resolve(root);
  const cfg = readConfig(root);
  const perToken = Number.isFinite(opts.charsPerToken) && opts.charsPerToken > 0 ? opts.charsPerToken : cfg.chars_per_token;
  const maxDepth = Number.isFinite(opts.maxSkillDepth) && opts.maxSkillDepth > 0 ? Math.floor(opts.maxSkillDepth) : cfg.max_skill_depth;
  const P = resolvePaths(cfg, opts, root);
  const posts = [];
  const findings = [];
  const notes = [];

  // 1. the global CLAUDE.md — the head of the chain
  const globalPost = measurePath('global_claude_md', 'file', 'global CLAUDE.md', P.globalClaudeMd, root, perToken);
  posts.push(globalPost);

  // 2. every @-include it pulls in, each its own post. A dead include is a FINDING: the chain declares a
  //    file that is not there, which is a broken instruction, not a free saving.
  const globalText = readFileSafe(P.globalClaudeMd) || '';
  const includeDir = path.dirname(P.globalClaudeMd);
  for (const inc of parseIncludes(globalText)) {
    const p = measurePath('include:' + inc, 'include', '@' + inc, path.resolve(includeDir, inc), root, perToken);
    posts.push(p);
    if (!p.exists) findings.push({ kind: 'dead_include', id: p.id, detail: 'the global CLAUDE.md includes `@' + inc + '` but no such file exists at ' + p.path + ' — a dead reference, not a saving' });
  }

  // 3. the ECC common rules, as ONE post with its files named. One post because the interesting question is
  //    "is this whole layer getting heavier", and because a per-file baseline would go stale every time a
  //    rule file is added — which is precisely the growth that must trip the check, not silently re-key it.
  let eccFiles = [];
  try {
    eccFiles = fs.readdirSync(P.eccRulesDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name).sort();
  } catch { eccFiles = []; }
  const eccDetail = eccFiles.map((n) => {
    const chars = (readFileSafe(path.join(P.eccRulesDir, n)) || '').length;
    return { file: n, chars, approx_tokens: estimateTokens(chars, perToken) };
  });
  const eccChars = eccDetail.reduce((n, f) => n + f.chars, 0);
  const eccInProject = isInside(root, P.eccRulesDir);
  posts.push({
    id: 'ecc_rules_common', kind: 'dir', label: 'rules/ecc/common/*.md (' + eccDetail.length + ' file(s))',
    path: P.eccRulesDir, in_project: eccInProject, access: eccInProject ? 'read-write (this project)' : 'read-only',
    exists: eccDetail.length > 0, chars: eccChars, approx_tokens: estimateTokens(eccChars, perToken), files: eccDetail,
  });

  // 4-5. the workspace and project CLAUDE.md
  posts.push(measurePath('workspace_claude_md', 'file', 'workspace CLAUDE.md', P.workspaceClaudeMd, root, perToken));
  posts.push(measurePath('project_claude_md', 'file', 'project CLAUDE.md', path.join(root, 'CLAUDE.md'), root, perToken));

  // 6-8. the skill catalogs — the name + description of every skill in EACH of the three sources a session
  //    carries, as three separate posts. This is the specific budget that overflowed on 2026-07-31 (the skill
  //    list was truncated and 48 skills went invisible) and the one this meter itself under-read until the
  //    second pass on 2026-08-01 (57 of 278 skills counted). They are kept apart, never summed into one
  //    figure: different owners, different lifecycles, and only the first is ours to edit.
  const enablement = readEnablement(P);
  const skillSources = [];
  for (const src of SKILL_SOURCES) {
    const p = measureSkillSource(src, P[src.key], root, perToken, maxDepth, enablement);
    posts.push(p);
    skillSources.push({
      id: p.id, label: src.label, path: p.path, in_project: p.in_project, access: p.access,
      exists: p.exists, skills: p.skills, without_frontmatter: p.without_frontmatter,
      chars: p.chars, approx_tokens: p.approx_tokens,
      skills_on_disk: p.skills_on_disk, disabled_skills: p.disabled_skills,
      disabled_chars: p.disabled_chars, disabled_approx_tokens: p.disabled_approx_tokens,
      unattributed_skills: p.unattributed_skills, enablement_aware: p.enablement_aware,
      deepest_depth: p.deepest_depth, depth_capped: p.depth_capped, note: p.note,
    });
    // a walk that stopped at its cap MIGHT be short — that possibility is a finding, not a footnote
    if (p.depth_capped) {
      findings.push({
        kind: 'depth_capped', id: p.id,
        detail: src.label + ': the SKILL.md walk stopped at its maximum depth of ' + maxDepth
          + ' and did not descend further, so this count of ' + p.skills + ' skill(s) may be short — raise '
          + '`max_skill_depth` in ' + CONFIG_REL.split(path.sep).join('/') + ' and re-measure',
      });
    }
  }

  const totalChars = posts.reduce((n, p) => n + p.chars, 0);
  const totalTokens = estimateTokens(totalChars, perToken);
  // POTENTIAL, not loaded. This is the weight that would arrive if the switched-off plugins were switched on.
  // It is a separate figure on purpose and is never folded into totalChars/totalTokens or into the baseline
  // comparison — the whole point of this pass is that on-disk weight stopped being counted as loaded weight.
  const potentialChars = posts.reduce((n, p) => n + (p.disabled_chars || 0), 0);
  const potentialTokens = estimateTokens(potentialChars, perToken);

  // --- compare against the recorded baseline -----------------------------------------------------------
  const th = cfg.thresholds;
  const newPosts = [];
  const retiredBaselinePosts = [];
  let reason;
  if (!cfg.baseline) {
    reason = 'no baseline recorded yet — measured ' + totalTokens + ' estimated tokens across ' + posts.length
      + ' post(s); run `--write-baseline` to start guarding growth';
  } else {
    reason = 'compared against the baseline recorded ' + (cfg.baseline.generated_at || 'at an unrecorded time');
    for (const p of posts) {
      const base = cfg.baseline.posts[p.id];
      if (!Number.isFinite(base)) { newPosts.push(p.id); continue; }
      const allowance = Math.max(Math.ceil(base * (th.post_growth_pct / 100)), th.post_growth_min_tokens);
      if (p.approx_tokens > base + allowance) {
        findings.push({
          kind: 'over_baseline', id: p.id,
          detail: p.label + ' grew to ' + p.approx_tokens + ' estimated tokens, over its baseline of ' + base
            + ' + an allowance of ' + allowance + ' (+' + (p.approx_tokens - base) + ')',
        });
      }
    }
    const livePostIds = new Set(posts.map((p) => p.id));
    for (const id of Object.keys(cfg.baseline.posts)) if (!livePostIds.has(id)) retiredBaselinePosts.push(id);

    // a source that HAD skills and now has none: the meter is reading low, which is the one failure a budget
    // meter must never absorb quietly. Distinct from a source that was never there (an honest zero, noted on
    // the post itself) and from one that merely shrank (ordinary movement).
    const baseSources = (cfg.baseline.skill_sources && typeof cfg.baseline.skill_sources === 'object') ? cfg.baseline.skill_sources : {};
    for (const s of skillSources) {
      const had = baseSources[s.id];
      if (!Number.isFinite(had) || had <= 0) continue;
      if (s.skills > 0) continue;
      findings.push({
        kind: 'source_vanished', id: s.id,
        detail: s.label + ' contributed ' + had + ' skill(s) when the baseline was recorded and contributes 0 now ('
          + (s.exists ? 'the directory ' + s.path + ' still exists but holds no SKILL.md' : 'the directory ' + s.path + ' is gone')
          + ') — the meter is now reading LOWER than reality unless that source genuinely went away; a meter '
          + 'that under-reports is worse than no meter, so this is red until it is explained or re-baselined',
      });
    }

    // THE TOTAL, COMPARED LIKE FOR LIKE. Both sides are restricted to the surface they have in common before
    // anything is called growth: the measured total minus posts the baseline never covered, against the
    // recorded total minus posts that no longer exist. Comparing the raw headlines instead would call every
    // widening of the meter a regression (a false alarm that trains everyone to ignore the real one) and every
    // retirement a saving. What is left after that subtraction IS growth, and is reported as such.
    const baseTotal = cfg.baseline.total_approx_tokens;
    if (Number.isFinite(baseTotal)) {
      const newTokens = posts.filter((p) => newPosts.includes(p.id)).reduce((n, p) => n + p.approx_tokens, 0);
      const retiredTokens = retiredBaselinePosts.reduce((n, id) => n + (Number.isFinite(cfg.baseline.posts[id]) ? cfg.baseline.posts[id] : 0), 0);
      const effectiveNow = totalTokens - newTokens;
      const effectiveBase = baseTotal - retiredTokens;
      const allowance = Math.max(Math.ceil(effectiveBase * (th.total_growth_pct / 100)), th.total_growth_min_tokens);
      if (effectiveNow > effectiveBase + allowance) {
        findings.push({
          kind: 'over_baseline_total', id: 'total',
          detail: 'the always-loaded chain grew to ' + effectiveNow + ' estimated tokens across the surface the '
            + 'baseline actually covers, over its baseline of ' + effectiveBase + ' + an allowance of '
            + allowance + ' (+' + (effectiveNow - effectiveBase) + '); the full measured surface, including '
            + newPosts.length + ' newly metered post(s), is ' + totalTokens + ' estimated tokens',
        });
      } else if (newTokens > 0 && totalTokens > baseTotal) {
        // THE CORRECTION CASE. The headline total is up, but not one baselined post grew: the rise is surface
        // the meter had simply never counted. Saying "regression" here would be a false alarm and would train
        // everyone to ignore the real one, so it is a NOTE that names the difference in words.
        const added = posts.filter((p) => newPosts.includes(p.id));
        notes.push({
          kind: 'measurement_widened', id: 'total',
          detail: 'the measured total rose from ' + baseTotal + ' to ' + totalTokens + ' estimated tokens, but this is '
            + 'a CORRECTION, not growth: no post the baseline covers grew past its allowance. ' + added.length
            + ' post(s) are newly METERED surface that was always loaded and simply never counted — '
            + added.map((p) => p.id + ' (+' + p.approx_tokens + ')').join(', ')
            + '. Re-run with `--write-baseline` to adopt the wider measurement as the new baseline.',
        });
      }
    }
    for (const id of retiredBaselinePosts) {
      notes.push({
        kind: 'retired_post', id,
        detail: 'the baseline still carries a post `' + id + '` that this measurement no longer produces — it was '
          + 'renamed or removed; its baseline number is being ignored rather than silently counted as a saving. '
          + 'Re-baseline to drop it.',
      });
    }
  }

  return {
    ok: findings.length === 0,
    generated_at: new Date().toISOString(),
    chars_per_token: perToken,
    max_skill_depth: maxDepth,
    estimate_note: ESTIMATE_NOTE,
    posts,
    skill_sources: skillSources,
    total_chars: totalChars,
    total_approx_tokens: totalTokens,
    // present-but-not-loaded weight, reported beside the total and never inside it
    potential_chars: potentialChars,
    potential_approx_tokens: potentialTokens,
    plugin_enablement: {
      available: enablement.available, reason: enablement.reason,
      enabled_count: enablement.enabled_count, plugin_count: enablement.plugin_count,
    },
    baseline: cfg.baseline,
    thresholds: th,
    findings,
    notes,
    new_posts: newPosts,
    retired_baseline_posts: retiredBaselinePosts,
    reason,
  };
}

/** writeBaseline(root, opts) -> {path, baseline} — records the CURRENT measurement as the baseline. This is
 *  deliberately a SEPARATE, explicit call and never happens as a side effect of measuring: a meter that
 *  re-baselines itself every run can never detect growth, it only ever describes the present. */
function writeBaseline(root, opts) {
  const rep = measure(root, opts);
  const cfg = readConfig(path.resolve(root));
  const posts = {};
  for (const p of rep.posts) posts[p.id] = p.approx_tokens;
  // the per-source skill COUNTS are recorded alongside the token figures, and they are what makes a silently
  // disappearing source detectable at all: tokens alone cannot tell "this source is gone" from "these skills
  // got shorter". See the source_vanished finding in measure().
  const skillSources = {};
  for (const s of rep.skill_sources || []) skillSources[s.id] = s.skills;
  cfg.baseline = {
    generated_at: rep.generated_at,
    chars_per_token: rep.chars_per_token,
    max_skill_depth: rep.max_skill_depth,
    estimate_note: ESTIMATE_NOTE,
    total_approx_tokens: rep.total_approx_tokens,
    total_chars: rep.total_chars,
    posts,
    skill_sources: skillSources,
  };
  const p = saveConfig(path.resolve(root), cfg);
  return { path: p, baseline: cfg.baseline };
}

/** skillSourceLine(rep) -> 'skills: project 57 + global 109 + plugins 112 = 278 (separate posts; global and
 *  plugins are outside the project root, read only)'. Its own helper because both this module's CLI and
 *  forge-doctor's printSummary must show the SAME breakdown — a doctor line quoting one number while the JSON
 *  holds three is how the 21%-coverage blind spot survived a whole day. Returns '' if there is nothing to say. */
function skillSourceLine(rep) {
  const src = (rep && rep.skill_sources) || [];
  if (!src.length) return '';
  const shortName = (id) => id.replace(/^skill_catalog_/, '');
  const total = src.reduce((n, s) => n + s.skills, 0);
  const off = src.reduce((n, s) => n + (s.disabled_skills || 0), 0);
  const parts = src.map((s) => shortName(s.id) + ' ' + s.skills + (s.exists ? '' : ' (absent)'));
  const outside = src.filter((s) => !s.in_project).map((s) => shortName(s.id));
  return 'skills: ' + parts.join(' + ') + ' = ' + total + ' LOADED, counted separately'
    + (off ? ' · ' + off + ' disabled (present on disk, not loaded — '
      + (rep.potential_approx_tokens || 0) + ' est. tokens of potential weight)' : '')
    + (outside.length ? ' (' + outside.join(' + ') + ' are outside the project root — read only)' : '');
}

/** summarize(rep) -> one human line, the shape forge-doctor's printSummary reuses. */
function summarize(rep) {
  if (!rep) return 'context budget: unavailable';
  const head = rep.total_approx_tokens + ' est. tokens across ' + rep.posts.length + ' always-loaded post(s)';
  const sk = skillSourceLine(rep);
  const tail = (sk ? ' · ' + sk : '');
  if (rep.ok) {
    const notes = (rep.notes || []).map((n) => n.detail);
    return head + tail + ' · ' + rep.reason + (notes.length ? ' · ' + notes.join(' · ') : '');
  }
  return head + tail + ' · ' + rep.findings.length + ' finding(s): ' + rep.findings.map((f) => f.detail).join(' · ');
}

module.exports = {
  measure, writeBaseline, readConfig, saveConfig, summarize, skillSourceLine,
  estimateTokens, parseIncludes, frontmatterField, defaultPaths, isInside,
  walkSkillCatalog, measureSkillSource,
  // 2026-08-01 — plugin enablement (see the PLUGIN ENABLEMENT block above). Exported so a caller/test can
  // audit a single attribution row instead of re-deriving the whole rule set.
  readEnablement, attributePluginSkill, pluginKeyFromPath,
  CONFIG_REL, DEFAULT_THRESHOLDS, DEFAULT_CHARS_PER_TOKEN, ESTIMATE_NOTE, MAX_SKILL_DEPTH, SKILL_SOURCES,
};

// ---- CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  let root = path.resolve(__dirname, '..', '..'), wantJson = false, wantBaseline = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--json') wantJson = true;
    else if (argv[i] === '--write-baseline') wantBaseline = true;
  }
  if (wantBaseline) {
    const r = writeBaseline(root);
    console.log('baseline written: ' + r.path);
    console.log('  ' + r.baseline.total_approx_tokens + ' estimated tokens total (' + ESTIMATE_NOTE + ')');
    process.exit(0);
  }
  const rep = measure(root);
  if (wantJson) console.log(JSON.stringify(rep, null, 2));
  else {
    console.log('Forge context budget — ' + root);
    console.log('  ' + ESTIMATE_NOTE);
    for (const p of rep.posts) {
      console.log('  ' + String(p.approx_tokens).padStart(7) + '  ' + p.label
        + (p.exists ? '' : '  [MISSING]') + (p.in_project ? '' : '  [outside project — read only]'));
    }
    console.log('  ' + String(rep.total_approx_tokens).padStart(7) + '  TOTAL LOADED (estimate)');
    if (rep.potential_approx_tokens) {
      console.log('  ' + String(rep.potential_approx_tokens).padStart(7) + '  present on disk but NOT loaded '
        + '(switched-off plugins — potential weight, deliberately NOT part of the total above)');
    }
    console.log('  plugins: ' + rep.plugin_enablement.reason);
    console.log('  ' + skillSourceLine(rep));
    for (const n of (rep.notes || [])) console.log('  note (' + n.kind + '): ' + n.detail);
    console.log('  ' + (rep.ok ? '✓ ' : '⚠ ') + summarize(rep));
  }
  process.exit(0);
}
