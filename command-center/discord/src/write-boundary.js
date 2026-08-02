import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Schrijf-grens per project. `cwd` is GEEN sandbox: met --permission-mode
// acceptEdits kan een agent ook buiten de projectmap schrijven. We geven daarom
// een expliciet settings-bestand mee met deny-regels voor de gevoelige plekken
// (globale Claude-config, .env-bestanden, de bot-map zelf).
const HOME = os.homedir();

export function buildDenyRules({ botDir = process.cwd() } = {}) {
  const claudeHome = path.join(HOME, '.claude');
  const rules = [
    // Globale Claude-config en credentials — nooit aanraken vanuit een remote run.
    `Write(${claudeHome}${path.sep}**)`,
    `Edit(${claudeHome}${path.sep}**)`,
    // De bot zelf: een run mag zijn eigen aanstuurder niet herschrijven.
    `Write(${botDir}${path.sep}**)`,
    `Edit(${botDir}${path.sep}**)`,
    // Secrets binnen elk project.
    'Write(**/.env)',
    'Edit(**/.env)',
    'Read(**/.credentials.json)',
  ];
  return rules;
}

// Schrijft (indien nodig) een settings-bestand voor dit project en geeft het pad
// terug voor `--settings`. Idempotent: alleen herschrijven als de inhoud wijzigt.
export function ensureProjectSettings(projectPath, { botDir = process.cwd(), stateDir } = {}) {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  const settings = { permissions: { deny: buildDenyRules({ botDir }) } };
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  const dir = path.join(stateDir ?? botDir, 'run-settings');
  const file = path.join(dir, `${path.basename(projectPath)}.json`);
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return file;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  } catch {
    return null;
  }
}
