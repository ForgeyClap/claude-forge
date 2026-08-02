import fs from 'node:fs';
import path from 'node:path';

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
    projectsDir: get('FORGE_PROJECTS_DIR', 'C:\\Users\\YOU\\Documents\\ForgeProjecten'),
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
