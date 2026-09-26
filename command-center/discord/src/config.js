import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// C1 fix (WP-C1, 2026-09-26 laptop re-audit — coordinator flag): the old default hard-coded the
// maintainer's own username (`C:\Users\YOU\Documents\ForgeProjects`), which does not exist on any
// other machine. Derived from the current user's real home directory instead.
//
// CORRECTION (WP-C2, 2026-09-26 laptop re-audit, finding #5): the previous version of this comment
// claimed this default is "one shared convention" with the gateway's own project-creation route —
// that overstated it. The gateway's `FORGE_PROJECTS_ROOT` (gateway/src/paths.mjs) is
// `path.join(SYNC_SCAN_ROOT, 'ForgeProjects')`, and `SYNC_SCAN_ROOT` is the PARENT of wherever the
// command-center repo itself happens to be cloned — NOT `<home>/Documents`. The two only resolve to
// the exact same folder when that repo is cloned directly under `<home>/Documents` (true for the
// maintainer's own machine, not guaranteed anywhere else). What genuinely IS shared: the folder
// NAME `ForgeProjects`, and the fact that `<home>/Documents` is unconditionally one of the roots
// the gateway's own multi-root discovery (paths.mjs's `SYNC_SCAN_ROOTS`) scans regardless of where
// the repo is cloned — so a project THIS bot creates under its default is always discoverable by
// the gateway, but a project the gateway's own "New project" button creates is only guaranteed
// discoverable by this bot's default when the repo sits directly under Documents. When the two
// diverge, `FORGE_PROJECTS_DIR` (env or `.env`) still overrides this bot's side for anyone who
// keeps projects elsewhere.
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), 'Documents', 'ForgeProjects');

function parseEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadConfig({ env = process.env, cwd = process.cwd(), envFile = '.env' } = {}) {
  const fileVars = parseEnvFile(path.join(cwd, envFile));
  const get = (key, fallback = '') => env[key] ?? fileVars[key] ?? fallback;

  const config = {
    transport: get('TRANSPORT', 'mock'),
    botToken: get('DISCORD_BOT_TOKEN'),
    guildId: get('DISCORD_GUILD_ID'),
    ownerUserIds: get('OWNER_USER_IDS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    expiryMs: (Number.parseFloat(get('EXPIRY_HOURS', '2')) || 2) * 3600 * 1000,
    maxQueuedPerThread: Number.parseInt(get('MAX_QUEUED_PER_THREAD', '10'), 10) || 10,
    globalMaxActiveRuns: Number.parseInt(get('GLOBAL_MAX_ACTIVE_RUNS', '2'), 10) || 2,
    stateDir: path.resolve(cwd, get('STATE_DIR', './state')),
    projectsDir: get('FORGE_PROJECTS_DIR', DEFAULT_PROJECTS_DIR),
    botHttpPort: Number.parseInt(get('BOT_HTTP_PORT', '3979'), 10) || 3979,
    managerPort: Number.parseInt(get('MANAGER_PORT', '3987'), 10) || 3987,
    runner: get('RUNNER', 'fake'),
    chatResetMinutes: Number.parseInt(get('CHAT_RESET_MINUTES', '30'), 10) || 0,
    ownerWebhookUrl: get('OWNER_WEBHOOK_URL', ''),
    pauseAtPercent: Number.parseInt(get('PAUSE_AT_PERCENT', '90'), 10) || 90,
    resumeAtPercent: Number.parseInt(get('RESUME_AT_PERCENT', '80'), 10) || 80,
    dailyCostLimitUsd: Number.parseFloat(get('DAILY_COST_LIMIT_USD', '0')) || 0,
    // Ongeldige waarde → standaard 8 (niet stil uitschakelen); -1 = expliciet uit.
    briefingHour: (() => {
      const raw = get('BRIEFING_HOUR', '8');
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n)) return 8;
      return n >= -1 && n <= 23 ? n : 8;
    })(),
  };

  if (config.transport === 'discord') {
    const missing = [];
    if (!config.botToken) missing.push('DISCORD_BOT_TOKEN');
    if (!config.guildId) missing.push('DISCORD_GUILD_ID');
    if (config.ownerUserIds.length === 0) missing.push('OWNER_USER_IDS');
    if (missing.length) {
      throw new Error(`TRANSPORT=discord vereist: ${missing.join(', ')} (zie .env.example)`);
    }
  }

  return config;
}

// Veilige weergave voor logs/health. ALLOWLIST: alleen deze velden mogen gelogd
// worden. Zo kan een nieuw configveld met een geheim (webhook, api-key) nooit per
// ongeluk in logs/bot.log en daarmee in het dashboard belanden.
const LOGGABLE = [
  'transport',
  'guildId',
  'expiryMs',
  'maxQueuedPerThread',
  'globalMaxActiveRuns',
  'stateDir',
  'projectsDir',
  'botHttpPort',
  'managerPort',
  'runner',
  'chatResetMinutes',
];
const SECRET_FIELDS = ['botToken', 'ownerWebhookUrl'];

export function describeConfig(config) {
  const safe = {};
  for (const key of LOGGABLE) if (key in config) safe[key] = config[key];
  for (const key of SECRET_FIELDS) {
    if (key in config) safe[key] = config[key] ? '***set***' : '(leeg)';
  }
  // Owner-ID's zijn geen geheim maar wel persoonsgegevens: alleen het aantal.
  if (Array.isArray(config.ownerUserIds)) safe.ownerUserIds = `${config.ownerUserIds.length} owner(s)`;
  return safe;
}
