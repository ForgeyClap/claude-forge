// GET /api/projects/:name/profile source: the SELECTED project's own `.claude/FORGE_PROJECT_PROFILE.md`
// (a free-text, bullet-per-field markdown convention this whole Forge fleet already uses — not a
// schema) plus `.claude/FORGE_VERSION.json` (the installed template version/sync timestamp). Same
// simple line-based parsing style as agents.mjs/skills.mjs — no markdown/yaml dependency.
//
// HONESTY NOTE: `FORGE_PROJECT_PROFILE.md`'s own "Project type:" line is free text (e.g. THIS
// project's own profile literally reads "tooling / meta — ... Mixed.") — it is never forced into
// the dashboard's closed `ProjectType` union. Returning it verbatim as `project_type_raw` lets a
// consumer show the real sentence rather than a guessed bucket; mapping it into one of the 8
// `ProjectType` values would be an invented classification, not a real field, so this module
// deliberately does not attempt that mapping.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';

// Real shape (verified against this repo's own FORGE_PROJECT_PROFILE.md): the colon sits INSIDE
// the bold markers, e.g. "- **Project name:** Forge V2 Hybrid Installer (...)" — not after them.
const BULLET_RE = /^-\s*\*\*([^*:]+):\*\*\s*(.*)$/;

function extractBulletValue(lines, label) {
  const wanted = label.toLowerCase();
  for (const line of lines) {
    const m = BULLET_RE.exec(line.trim());
    if (!m) continue;
    if (m[1].trim().toLowerCase() === wanted) return m[2].trim();
  }
  return null;
}

// fix-placeholder (forge-2026-07-29-cc-finish): a live-fleet inventory across every
// currently-registered project (`GET /api/projects` -> `GET /api/projects/:name/profile`,
// 2026-07-29) found several projects ("100 apps", "a cashflow project", "an e-commerce project") whose
// FORGE_PROJECT_PROFILE.md was never filled in past the scaffold: the bullet exists, but its
// value is still the literal fill-in-the-blank token from the template, e.g.
// "- **Project goal:** <one or two lines>". Returning that string verbatim (as this module did
// before this fix) makes the dashboard render template syntax as if it were real project prose —
// functionally indistinguishable from fabricated content to the person reading it.
//
// The rule below is DELIBERATELY narrow: a value only counts as an unfilled placeholder when the
// ENTIRE trimmed value is a single `<...>` token (anchored `^<[^<>]*>$` — start-to-end, no other
// characters outside the brackets). This was verified against the real value of this field across
// every registered project before being written: real free-text goals (this project's own,
// AutoWeb's, "an accounting desktop app progamma"'s, etc.) never start with `<`, so the anchor can never
// truncate legitimate prose that merely happens to contain a `<` character mid-sentence. A
// candidate substring/contains rule was deliberately rejected for the same reason: it would have
// wrongly nulled "demo-sandbox-automation"'s honest `project_goal` ("`unknown` — PROJECT.md
// \"Business purpose\" is TODO. Needs verification from owner.") — a real, already-honest
// generated sentence that happens to contain the word "TODO", not a raw template leak. No
// TODO/TBD/"..." bare-token variant was found as a WHOLE field value anywhere in the current
// fleet, so none is added here — only what was actually observed gets a rule (see this run's
// build report for the full per-project inventory).
//
// FOLLOW-UP LANDED (Lead, same run): the parenthetical variant flagged above is now covered too,
// by the same start-to-end anchor and only after the same empirical check. `forge-system-public`'s
// canonical-template profile carries "(set on first `/forge` run)", "(detected on first run — …)"
// and "(from the user's first task)" — fill-in-the-blank tokens by any other name, and just as
// misleading on screen as the `<…>` form. Before adding the rule, every one of the four fields was
// re-read across all 15 registered projects: exactly THREE values in the entire fleet are wholly
// parenthetical, and all three are that template's placeholders. Every other parenthesis in the
// fleet sits mid-sentence inside real prose — "Forge V2 Hybrid Installer (\"my project (v2)!\")",
// "new (greenfield)", "n8n / automation (booking + quotation backend)", "unknown (empty folder at
// install time …)" — none of which the anchored form can touch, because a legitimate name, type,
// goal or maturity is never wrapped in parentheses end-to-end. Same discipline as above: the rule
// was written to the evidence, not the evidence to the rule.
const PLACEHOLDER_ONLY_RE = /^(?:<[^<>]*>|\([^()]*\))$/;

function isPlaceholderOnly(value) {
  return typeof value === 'string' && PLACEHOLDER_ONLY_RE.test(value.trim());
}

// A bullet that exists but carries no real content (placeholder-only OR blank after the colon)
// is reported as absent (`null`) rather than as the literal scaffold text — with the field name
// recorded in `unfilledFields` so a consumer can tell "never filled in" apart from "this
// project's profile never had this bullet at all" (which extractBulletValue already reports as
// `null` on its own, with no entry here).
function normalizeField(rawValue, key, unfilledFields) {
  if (rawValue === null) return null;
  if (rawValue === '' || isPlaceholderOnly(rawValue)) {
    unfilledFields.push(key);
    return null;
  }
  return rawValue;
}

function readProfile(profilePath) {
  let text;
  try { text = fs.readFileSync(profilePath, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);
  const raw = {
    project_name: extractBulletValue(lines, 'Project name'),
    project_type_raw: extractBulletValue(lines, 'Project type'),
    project_goal: extractBulletValue(lines, 'Project goal'),
    maturity: extractBulletValue(lines, 'Maturity'),
  };
  const unfilledFields = [];
  return {
    project_name: normalizeField(raw.project_name, 'project_name', unfilledFields),
    project_type_raw: normalizeField(raw.project_type_raw, 'project_type_raw', unfilledFields),
    project_goal: normalizeField(raw.project_goal, 'project_goal', unfilledFields),
    maturity: normalizeField(raw.maturity, 'maturity', unfilledFields),
    unfilledFields,
  };
}

function readVersion(versionPath) {
  try { return JSON.parse(fs.readFileSync(versionPath, 'utf8')); } catch { return null; }
}

export function buildProjectProfile(projectPath) {
  const claudeDir = path.join(projectPath, '.claude');
  const profilePath = path.join(claudeDir, 'FORGE_PROJECT_PROFILE.md');
  const versionPath = path.join(claudeDir, 'FORGE_VERSION.json');

  if (!containmentOk(claudeDir, profilePath) || !containmentOk(claudeDir, versionPath)) {
    return { ok: false, error: 'path containment violation' };
  }

  const profile = readProfile(profilePath);
  const version = readVersion(versionPath);

  return {
    ok: true,
    profile_present: profile !== null,
    project_name: profile ? profile.project_name : null,
    project_type_raw: profile ? profile.project_type_raw : null,
    project_goal: profile ? profile.project_goal : null,
    maturity: profile ? profile.maturity : null,
    // Explicit, honest signal (fix-placeholder): which of the four fields above were nulled
    // because their bullet only ever held unfilled scaffold text (or was blank) — never invented,
    // never silently dropped. Always an array (empty when the profile is fully filled in, or
    // when there is no profile file at all).
    profile_unfilled_fields: profile ? profile.unfilledFields : [],
    version_present: version !== null,
    forge_version: version ? (version.forge_version || null) : null,
    synced_at: version ? (version.synced_at || null) : null,
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}
